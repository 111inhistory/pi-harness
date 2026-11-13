/** Request-local current instructions; the SDK owns history and transport encoding. */
import type { SystemMessage } from '@earendil-works/pi-ai';
import type { TranscriptMessageLike } from './session-transcript.ts';

/** Append current owned sections without modifying the caller's messages. */
export function appendCurrentSections<M extends TranscriptMessageLike>(
  messages: readonly M[],
  sections: Readonly<Record<string, string | null | undefined>>,
): readonly (M | SystemMessage)[] {
  const current = Object.fromEntries(Object.entries(sections).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0,
  ));
  if (Object.keys(current).length === 0) return messages;
  return [...messages, { role: 'system', content: '', sections: current, timestamp: 0 }];
}
