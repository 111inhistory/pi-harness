/**
 * Append-only transcript assembly shared by Capability and Subagent.
 *
 * The inherited prefix is never rewritten: no leading prompt replacement, no
 * tool-list filtering and no historical declaration removal. New instructions,
 * tool declarations and blocked-tool notes are appended as one later system
 * message, which Pi's native adapters convert for Responses and Anthropic.
 *
 * Tool removal is not part of this iteration. There is deliberately no removal
 * input and this module never writes `toolsRemoved`; a blocked tool remains
 * declared and is explained as a soft note, while the tool-call hook stays the
 * authority that rejects execution.
 */
import {
  declarationsEqual,
  getCurrentTools,
  toToolDeclaration,
  type SystemMessage,
  type Tool,
} from '@earendil-works/pi-ai';

/** Minimal transcript shape; custom agent messages pass through untouched. */
export interface TranscriptMessage {
  readonly role: string;
  readonly content?: unknown;
  readonly sections?: Readonly<Record<string, string | null>> | undefined;
  readonly toolsAdded?: readonly Tool[] | undefined;
  readonly toolsRemoved?: readonly { readonly name: string }[] | undefined;
  readonly timestamp?: number | undefined;
}

export interface SessionInstruction {
  /** Instruction text appended after the inherited transcript. */
  readonly text?: string | undefined;
  /** Named prompt sections appended at this position. */
  readonly sections?: Readonly<Record<string, string>> | undefined;
}

export interface SessionAddition {
  readonly instructions?: SessionInstruction | undefined;
  /**
   * Complete declarations for newly available tools. A same-name declaration
   * whose interface changed is appended again; the earlier declaration stays
   * in place as history.
   */
  readonly declarations?: readonly Tool[] | undefined;
  /**
   * Pseudo-removed tools. Each name becomes a soft blocking note; no
   * `toolsRemoved` event is emitted.
   */
  readonly blockedTools?: readonly string[] | undefined;
}

export interface SessionTranscriptResult<M extends TranscriptMessage> {
  readonly messages: readonly (M | SystemMessage)[];
  /** The system message appended by this call, or undefined for a no-op. */
  readonly appended: SystemMessage | undefined;
}

/** Stable soft-blocking wording; execution is rejected by the tool-call hook. */
export function softToolBlockNote(name: string): string {
  return `Tool ${name} is unavailable in this session. Do not call it; execution is blocked.`;
}

/** Tolerant shape for stored transcript messages; declaration payloads stay unknown. */
export interface TranscriptMessageLike {
  readonly role?: string | undefined;
  readonly content?: unknown;
  readonly toolsAdded?: readonly unknown[] | undefined;
  readonly toolsRemoved?: readonly unknown[] | undefined;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolDeclaration(value: unknown): Tool | null {
  if (!isRecord(value)) return null;
  const name = value['name'];
  const description = value['description'];
  const parameters = value['parameters'];
  if (typeof name !== 'string' || typeof description !== 'string' || !isRecord(parameters)) return null;
  return toToolDeclaration(value as unknown as Tool);
}

function toolName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const name = value['name'];
  return typeof name === 'string' ? name : null;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    if (!isRecord(part) || part['type'] !== 'text' || typeof part['text'] !== 'string') return [];
    return [part['text']];
  }).join('\n');
}

/** First declarations, in transcript order. No executable handles or session state. */
export function firstToolDeclarations(messages: readonly TranscriptMessageLike[]): Tool[] {
  const tools = new Map<string, Tool>();
  for (const message of messages) {
    if (message.role !== 'system') continue;
    for (const candidate of message.toolsAdded ?? []) {
      const tool = toolDeclaration(candidate);
      if (tool !== null && !tools.has(tool.name)) tools.set(tool.name, tool);
    }
  }
  return [...tools.values()];
}

/**
 * Request-only projection: declarations are append-only, execution is NOT enabled.
 * Pi's executable registry still enforces the live loadout. Replay permission changes
 * where they originally happened, rather than patching the leading tools or prompt.
 */
export function additiveToolTranscript<T extends TranscriptMessageLike>(messages: readonly T[]): T[] {
  const declared = new Map<string, Tool>();
  const enabled = new Set<string>();
  return messages.map((message) => {
    if (message.role !== 'system') return message;
    const notes: string[] = [];
    for (const reference of message.toolsRemoved ?? []) {
      const name = toolName(reference);
      if (name === null) continue;
      enabled.delete(name);
      notes.push(softToolBlockNote(name));
    }
    const additions: Tool[] = [];
    for (const candidate of message.toolsAdded ?? []) {
      const tool = toolDeclaration(candidate);
      if (tool === null) continue;
      const previous = declared.get(tool.name);
      if (!previous) {
        declared.set(tool.name, tool);
        additions.push(tool);
      } else if (!declarationsEqual(previous, tool)) {
        // A later declaration under the same name replaces the earlier one on
        // transports that support in-place tool changes. Dropping it would keep
        // sending the stale interface and schema, so replay the replacement
        // declaration instead of only noting it.
        declared.set(tool.name, tool);
        additions.push(tool);
        notes.push(`Tool ${tool.name} has updated interface or usage guidance. Inspect its current interface before calling it; execution validates current arguments.`);
      } else if (!enabled.has(tool.name)) {
        notes.push(`Tool ${tool.name} is available again.`);
      }
      enabled.add(tool.name);
    }
    if (!message.toolsRemoved?.length && notes.length === 0 && additions.length === (message.toolsAdded?.length ?? 0)) return message;
    const { toolsAdded: _added, toolsRemoved: _removed, ...rest } = message;
    const content = messageText(message.content);
    return {
      ...rest,
      content: [content, ...notes.filter((note) => !content.includes(note))].filter(Boolean).join('\n\n'),
      ...(additions.length ? { toolsAdded: additions } : {}),
    } as unknown as T;
  });
}

function newDeclarations(messages: readonly TranscriptMessage[], declarations: readonly Tool[]): Tool[] {
  const current = new Map(getCurrentTools(messages).map((tool) => [tool.name, tool]));
  const additions: Tool[] = [];
  for (const candidate of declarations) {
    const tool = toToolDeclaration(candidate);
    const previous = current.get(tool.name);
    if (previous !== undefined && declarationsEqual(previous, tool)) continue;
    current.set(tool.name, tool);
    additions.push(tool);
  }
  return additions;
}

function appendedContent(instructions: SessionInstruction | undefined, notes: readonly string[]): string {
  const text = instructions?.text?.trim() ?? '';
  return [text, ...notes].filter((part) => part.length > 0).join('\n\n');
}

function appendedSections(
  instructions: SessionInstruction | undefined,
): Record<string, string> | undefined {
  const entries = Object.entries(instructions?.sections ?? {}).filter(([, value]) => value.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Append one system message after the inherited transcript. Existing messages
 * keep their identity and declaration order; only the returned tail is new.
 */
export function appendSessionTranscript<M extends TranscriptMessage>(
  messages: readonly M[],
  addition: SessionAddition,
): SessionTranscriptResult<M> {
  const blockedNotes = [...new Set(addition.blockedTools ?? [])]
    .filter((name) => name.length > 0)
    .map(softToolBlockNote);
  const declarations = newDeclarations(messages, addition.declarations ?? []);
  const content = appendedContent(addition.instructions, blockedNotes);
  const sections = appendedSections(addition.instructions);

  if (content.length === 0 && sections === undefined && declarations.length === 0) {
    return { messages, appended: undefined };
  }

  const appended: SystemMessage = {
    role: 'system',
    content,
    ...(sections === undefined ? {} : { sections }),
    ...(declarations.length === 0 ? {} : { toolsAdded: declarations }),
    timestamp: 0,
  };
  return { messages: [...messages, appended], appended };
}
