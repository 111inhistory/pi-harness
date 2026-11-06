/**
 * Subagent guidance table, kept independent of the tool surface so Capability
 * can project guidance without importing surface/runtime modules.
 *
 * Each entry uses the original prompt asset text. The common entry is anchored
 * by the first Subagent namespace tool; the specific entries are anchored by
 * their own first declaration. Table order is common-first at a shared anchor.
 */
import { promptString, promptStrings } from '../prompt-text.ts';
import type { ToolGuidance } from '../tool-guidance.ts';

export const SUBAGENT_TOOL_GUIDANCE: readonly ToolGuidance[] = Object.freeze([
  {
    id: 'subagent',
    tools: ['subagent_create', 'subagent_list', 'subagent_stop', 'msg_write'],
    text: promptString('subagent-tools.json', 'instructions'),
  },
  {
    id: 'subagent_create',
    tools: ['subagent_create'],
    text: promptString('subagent-tools.json', 'create', 'guideline'),
  },
  {
    id: 'msg_write',
    tools: ['msg_write'],
    text: promptStrings('subagent-tools.json', 'msg_write', 'guidelines').join('\n\n'),
  },
]);
