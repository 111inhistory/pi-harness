/**
 * Subagent guidance table, kept independent of the tool surface so Capability
 * can project guidance without importing surface/runtime modules.
 *
 * Each entry supplies the current prompt asset text. Initial guidance follows
 * its first tool declaration; recorded versions keep their original placement
 * and changed text is delivered as a later system update.
 */
import { promptString, promptStrings } from '../prompt-text.ts';
import type { ToolGuidance } from '../tool-guidance.ts';

export const SUBAGENT_TOOL_GUIDANCE: readonly ToolGuidance[] = Object.freeze([
  {
    id: 'subagent',
    namespace: 'subagent',
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
