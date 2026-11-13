/** Test-only composition of the production current-state Capability sections. */
import {
  CAPABILITY_SECTION,
  capabilityPromptSections,
  type CapabilityPromptOptions,
  type ProjectionMessage,
} from '../../../src/capability/prompt.ts';

export function projectCapabilitySnapshot(
  messages: readonly ProjectionMessage[],
  branch: readonly unknown[] | null | undefined,
  options: CapabilityPromptOptions = {},
): ProjectionMessage[] {
  const rendered = capabilityPromptSections(branch, options)[CAPABILITY_SECTION];
  if (typeof rendered !== 'string' || rendered.trim().length === 0) return [...messages];
  const wrapped = `<${CAPABILITY_SECTION}>\n${rendered}\n</${CAPABILITY_SECTION}>`;
  return [
    ...messages,
    {
      role: 'system',
      content: '',
      sections: { [CAPABILITY_SECTION]: wrapped },
      timestamp: messages.at(-1)?.timestamp ?? 0,
    },
  ];
}
