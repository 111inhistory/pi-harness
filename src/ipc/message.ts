/**
 * Managed message construction for Agent endpoints.
 *
 * The caller supplies message text only. The host constructs the sender
 * envelope and the single NDJSON frame, so multiline text, JSON-looking text
 * and scalar-looking text can never change the sender identity or split into
 * multiple messages.
 */

export interface ManagedMessage {
  from: string;
  content: string;
}

export class ManagedMessageError extends Error {
  readonly code = "invalid_message";

  constructor(message: string) {
    super(message);
    this.name = "ManagedMessageError";
  }
}

/** Accept pure content (including an empty message) without parsing it. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content instanceof Uint8Array) return Buffer.from(content).toString("utf8");
  if (content === null || content === undefined) {
    throw new ManagedMessageError("Message content is required.");
  }
  return String(content);
}

export function assertSender(senderId: unknown): asserts senderId is string {
  if (typeof senderId !== "string" || senderId.trim() === "") {
    throw new ManagedMessageError("A non-empty sender identity is required for a managed endpoint.");
  }
}

/** Build exactly one envelope and frame; the content is never reparsed. */
export function managedFrame({ senderId, content }: { senderId: string; content: unknown }): {
  message: ManagedMessage;
  frame: string;
} {
  assertSender(senderId);
  const message: ManagedMessage = { from: senderId, content: messageText(content) };
  return { message, frame: `${JSON.stringify(message)}\n` };
}
