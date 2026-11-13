import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installHarnessSession } from '../src/session/application.ts';
import { installRootSubagentSurface } from '../src/subagent/extension.ts';

/** Compose the root host; child sessions install their own scoped surfaces. */
export default function harnessExtension(api: ExtensionAPI): void {
  const session = installHarnessSession(api);
  installRootSubagentSurface(api, session);
}
