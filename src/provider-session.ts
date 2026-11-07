/**
 * Exact provider-transport classification shared by Capability and Subagent.
 *
 * Provider encoding stays in Pi. This module only answers which native
 * transcript features the concrete model declares, so callers can decide
 * whether new instructions and tool declarations stay at the transcript tail
 * or whether the transport will rewrite its leading prompt/tool inventory.
 *
 * Support is read from the model's exact `api` and explicit `compat` booleans.
 * It is never inferred from a model or provider name. Every other transport
 * is reported as not adapted by the Harness: the policy does not modify their
 * compat or Pi's native request behavior.
 */
import type { TranscriptToolSupport } from '@earendil-works/pi-ai';

export type ProviderTransport = 'responses' | 'anthropic' | 'completions' | 'other';

export interface ProviderSessionPolicy {
  readonly transport: ProviderTransport;
  /**
   * Pi keeps later system messages in place instead of replaying them into the
   * leading prompt. Instructions can therefore be appended without rewriting
   * the cached prefix.
   */
  readonly midConversationSystemMessages: boolean;
  /**
   * SDK capability description for how Pi can express tool declarations after
   * the first request: `changes` declares every tool in place and supports
   * same-name updates, `additions` can only add new names, `none` rewrites the
   * top-level list. This describes the transport; it does not authorize this
   * iteration to send removal events.
   */
  readonly toolSupport: TranscriptToolSupport;
}

const RESPONSES_APIS: ReadonlySet<string> = new Set([
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
]);

const ANTHROPIC_APIS: ReadonlySet<string> = new Set(['anthropic-messages']);

const COMPLETIONS_APIS: ReadonlySet<string> = new Set(['openai-completions']);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compatOf(model: unknown): UnknownRecord {
  if (!isRecord(model)) return {};
  const compat = model['compat'];
  return isRecord(compat) ? compat : {};
}

/** Exact transport identity; compat never turns another API into one of these. */
export function classifyProviderTransport(model: unknown): ProviderTransport {
  if (!isRecord(model)) return 'other';
  const api = model['api'];
  if (typeof api !== 'string') return 'other';
  if (RESPONSES_APIS.has(api)) return 'responses';
  if (ANTHROPIC_APIS.has(api)) return 'anthropic';
  if (COMPLETIONS_APIS.has(api)) return 'completions';
  return 'other';
}

/**
 * The two additive bits are independent: mid-conversation instructions and
 * in-place tool declarations. A transport may support one without the other.
 */
export function providerSessionPolicy(model: unknown): ProviderSessionPolicy {
  const transport = classifyProviderTransport(model);
  if (transport === 'other') {
    return { transport, midConversationSystemMessages: false, toolSupport: 'none' };
  }

  const compat = compatOf(model);
  const midConversationSystemMessages = compat['supportsMidConvoSystemMessages'] === true;

  if (transport === 'completions') {
    // Chat Completions only supports incremental tool additions if both
    // mid-conversation system messages and mid-conversation tool additions
    // are explicitly declared. It does not support in-place changes.
    const midConversationToolAdditions = compat['supportsMidConvoToolAdditions'] === true;
    return {
      transport,
      midConversationSystemMessages,
      toolSupport: midConversationSystemMessages && midConversationToolAdditions
        ? 'additions'
        : 'none',
    };
  }

  if (transport === 'anthropic') {
    return {
      transport,
      midConversationSystemMessages,
      // Pi's Anthropic adapter anchors in-place tool changes on an initial tool
      // declaration; without this bit later additions go into the tool list.
      toolSupport: midConversationSystemMessages && compat['supportsMidConvoToolChanges'] === true
        ? 'changes'
        : 'none',
    };
  }

  // Exactly Pi's getResponsesToolSupport rule: additional_tools needs
  // mid-conversation system messages and can replace a same-name declaration;
  // tool search can only add names and does not itself require that bit.
  const additionalTools = compat['supportsAdditionalTools'] === true;
  const toolSearch = compat['supportsToolSearch'] === true;
  return {
    transport,
    midConversationSystemMessages,
    toolSupport: midConversationSystemMessages && additionalTools
      ? 'changes'
      : toolSearch
        ? 'additions'
        : 'none',
  };
}
