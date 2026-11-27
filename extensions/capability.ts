import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import capabilityExtension from '../src/capability/extension.ts';
import { installCapabilityMcp } from '../src/capability/native-discovery.ts';
import { installMainSessionCacheIdentity } from '../src/session-cache-runtime.ts';
import { installHookSurface } from '../src/hooks/extension.ts';
import { installHookStats } from '../src/hooks/stats.ts';

export default function capability(pi: ExtensionAPI): void {
  const capabilityPort = capabilityExtension(pi);
  installHookSurface(pi, capabilityPort, installHookStats(pi));
  installMainSessionCacheIdentity(pi);
  installCapabilityMcp(pi);
}
