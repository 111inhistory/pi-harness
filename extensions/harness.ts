import { installResultRendering } from '../src/result-rendering.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import subagentExtension from '../src/subagent/extension.ts';
import capabilityExtension from './capability.ts';
import { installBtwCommand } from '../src/btw/command.ts';
import { installCapabilityMcp } from '../src/capability/native-discovery.ts';

/** One assembly for the shared execution backend and Capability discovery. */
export default function harnessExtension(pi: ExtensionAPI): void {
  installResultRendering(pi);
  subagentExtension(pi);
  capabilityExtension(pi);
  installCapabilityMcp(pi);
  installBtwCommand(pi);
}
