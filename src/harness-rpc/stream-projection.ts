/**
 * JSON projection of a child session's native events.
 *
 * This mirrors Pi's own RPC/JSON stdout projection: a streaming
 * `message_update` carries the full cumulative assistant message, which would
 * grow with every delta. The projection keeps the delta event and the message
 * usage, drops the cumulative `partial`, and for `toolcall_start` exposes the
 * tool-call id and name so a client can correlate the later execution events.
 *
 * Every other native event passes through unchanged, so `toolCallId` /
 * `parentToolCallId`, thinking blocks the provider actually returned, and the
 * distinct `tool_execution_*` events are preserved.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutPartial(event: Record<string, unknown>): Record<string, unknown> {
  if (!('partial' in event)) return event;
  const { partial: _partial, ...rest } = event;
  return rest;
}

function projectAssistantEvent(event: unknown): unknown {
  if (!isRecord(event)) return event;
  if (event.type === 'toolcall_start') {
    const partial = event.partial;
    const index = event.contentIndex;
    let id: unknown;
    let toolName: unknown;
    if (isRecord(partial) && Array.isArray(partial.content) && typeof index === 'number') {
      const part = partial.content[index];
      if (isRecord(part) && part.type === 'toolCall') {
        id = part.id;
        toolName = part.name;
      }
    }
    return { ...withoutPartial(event), id, toolName };
  }
  return withoutPartial(event);
}

/** Project one native session event to its wire shape. */
export function projectSessionEvent(event: unknown): unknown {
  if (!isRecord(event) || event.type !== 'message_update') return event;
  const message = event.message;
  if (!isRecord(message) || message.role !== 'assistant') return event;
  return {
    type: 'message_update',
    usage: message.usage,
    assistantMessageEvent: projectAssistantEvent(event.assistantMessageEvent),
  };
}
