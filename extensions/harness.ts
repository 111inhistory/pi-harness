import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import subagentExtension from '../src/subagent/extension.ts';
import capabilityExtension from './capability.mjs';
import { installCapabilityMcp } from '../src/capability/native-discovery.ts';

/** One assembly for the shared execution backend and Capability discovery. */
export default function harnessExtension(pi: ExtensionAPI): void {
  subagentExtension(pi);
  capabilityExtension(pi);
  installCapabilityMcp(pi);
}
