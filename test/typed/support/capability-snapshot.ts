/** Test-only composition of the production current-state Capability sections. */
import { appendCurrentSections } from '../../../src/request-instructions.ts';
import {
  capabilityPromptSections,
  type CapabilityPromptOptions,
  type ProjectionMessage,
} from '../../../src/capability/prompt.ts';

export function projectCapabilitySnapshot(
  messages: readonly ProjectionMessage[],
  branch: readonly unknown[] | null | undefined,
  options: CapabilityPromptOptions = {},
): ProjectionMessage[] {
  return [...appendCurrentSections(messages, capabilityPromptSections(branch, options))] as ProjectionMessage[];
}
