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

/** A frame accepted from an external socket client. */
export interface InboundFrame {
  from: string;
  content: string;
}

/** Stable refusal for an inbound frame that cannot identify both fields. */
export class InboundFrameError extends Error {
  readonly code = "invalid_message";

  constructor(message: string) {
    super(message);
    this.name = "InboundFrameError";
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

/**
 * Validate an untrusted inbound frame and return only the two contract fields.
 * A missing, blank or non-string sender is refused; there is deliberately no
 * fallback identity. Shape validation is not authentication: a caller that
 * names a known Agent is still an unauthenticated external process.
 */
export function validateInboundFrame(input: unknown): InboundFrame {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new InboundFrameError("An inbound frame must be a JSON object.");
  }
  const record = input as Record<string, unknown>;
  const from = record["from"];
  const content = record["content"];
  if (typeof from !== "string" || from.trim() === "") {
    throw new InboundFrameError("An inbound frame requires an explicit non-empty sender identity.");
  }
  if (typeof content !== "string") {
    throw new InboundFrameError("An inbound frame requires a string content body.");
  }
  return { from, content };
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
