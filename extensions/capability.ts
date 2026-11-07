import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import capabilityExtension from '../src/capability/extension.ts';
import { installCapabilityMcp } from '../src/capability/native-discovery.ts';

export default function capability(pi: ExtensionAPI): void {
  capabilityExtension(pi);
  installCapabilityMcp(pi);
}
