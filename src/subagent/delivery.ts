/** One independent custom message per event. Pi owns queueing and execution. */
export const DELIVERY_CUSTOM_TYPE = "agent-delivery";

export interface DeliveryTerminal {
  status: string;
  details?: unknown;
}

export interface DeliveryEntry {
  sourceId: string;
  round: string | number;
  content: string;
  terminal?: DeliveryTerminal;
}

export interface DeliveryCustomMessage {
  role: "custom";
  customType: typeof DELIVERY_CUSTOM_TYPE;
  content: string;
  display: true;
  details: {
    sourceId: string;
    round: string | number;
    source: "agent" | "host";
    status: string;
    terminal?: DeliveryTerminal;
  };
  timestamp: number;
}

export interface DeliveryResult {
  accepted: boolean;
  reason?: "inactive";
  /** Native handoff only, not model acknowledgement. Never rejects. */
  completion?: Promise<{ ok: boolean; error?: unknown }>;
}

function formatDetails(details: unknown): string {
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details) ?? String(details);
  } catch {
    return String(details);
  }
}

export function sendDelivery(
  entry: DeliveryEntry,
  options: {
    send(message: DeliveryCustomMessage): void | Promise<void>;
    isActive?: () => boolean;
  },
): DeliveryResult {
  if (typeof entry.sourceId !== "string" || entry.sourceId === "") throw new TypeError("Delivery sourceId must be a non-empty string.");
  if (typeof entry.round !== "string" && typeof entry.round !== "number") throw new TypeError("Delivery round must be a string or number.");
  if (typeof entry.content !== "string") throw new TypeError("Delivery content must be a string.");
  try {
    if (options.isActive !== undefined && !options.isActive()) return { accepted: false, reason: "inactive" };
  } catch {
    return { accepted: false, reason: "inactive" };
  }
  let content = entry.content;
  if (entry.terminal !== undefined) {
    const details = entry.terminal.details === undefined ? "" : `: ${formatDetails(entry.terminal.details)}`;
    const marker = `[Subagent ${entry.sourceId} ${entry.terminal.status} (round ${String(entry.round)})]${details}`;
    content = content === "" ? marker : `${content}\n\n${marker}`;
  }
  const message: DeliveryCustomMessage = {
    role: "custom", customType: DELIVERY_CUSTOM_TYPE, content, display: true,
    details: { sourceId: entry.sourceId, round: entry.round,
      source: entry.terminal === undefined ? "agent" : "host",
      status: entry.terminal?.status ?? "running",
      ...(entry.terminal === undefined ? {} : { terminal: entry.terminal }),
    },
    timestamp: Date.now(),
  };
  try {
    const completion = Promise.resolve(options.send(message)).then(
      () => ({ ok: true }), (error: unknown) => ({ ok: false, error }),
    );
    return { accepted: true, completion };
  } catch (error) {
    return { accepted: true, completion: Promise.resolve({ ok: false, error }) };
  }
}
