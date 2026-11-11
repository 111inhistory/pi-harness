/**
 * Observed request wire for generated capability histories.
 *
 * The generated histories describe what the model saw, not what a helper thinks
 * it should see. This adapter therefore runs the installed Pi Responses
 * serializer and exposes plain observations over its output; it contains no
 * expected values, reference model or assertions. Responses is used because
 * its additive `additional_tools` items preserve the declaration chronology,
 * while a Chat Completions payload only exposes the current top-level tool set.
 */
import type { Api, Message, Model } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { convertResponsesMessages } from '@earendil-works/pi-ai/api/openai-responses-shared';

/** One tool declaration exactly as the serialized request carries it. */
export interface DeclaredTool {
  readonly name: string;
  readonly description: string | undefined;
  readonly parameters: unknown;
}

type JsonRecord = { readonly [key: string]: unknown };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serialize the request exactly as an additive Responses transport would.
 * The returned JSON is the live converter output, not a projected copy.
 */
export async function serializedRequest(
  model: Model<Api>,
  messages: readonly Message[],
): Promise<readonly unknown[]> {
  return convertResponsesMessages(
    model,
    normalizeContext({ messages: [...messages] }),
    new Set([model.provider]),
    {
      includeSystemPrompt: true,
      supportsMidConvoSystemMessages: true,
      supportsAdditionalTools: true,
    },
  );
}

/**
 * Every declaration visible in the request, in wire order. A redeclaration
 * appears again at its own position rather than replacing the earlier one.
 */
export function declaredTools(wire: readonly unknown[]): readonly DeclaredTool[] {
  return wire.flatMap(item => {
    if (!isRecord(item) || item['type'] !== 'additional_tools' || !Array.isArray(item['tools'])) return [];
    return item['tools'].flatMap(tool => {
      if (!isRecord(tool) || typeof tool['name'] !== 'string') return [];
      return [{
        name: tool['name'],
        description: typeof tool['description'] === 'string' ? tool['description'] : undefined,
        parameters: tool['parameters'],
      }];
    });
  });
}
