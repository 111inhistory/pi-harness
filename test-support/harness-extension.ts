import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import resultRendering from '../extensions/result-rendering.ts';
import subagent from '../extensions/subagent.ts';
import capability from '../extensions/capability.ts';
import btw from '../extensions/btw.ts';

/** Shared-API fixture; native loader coverage exercises the separate entry APIs. */
export default function harnessFixture(pi: ExtensionAPI): void {
  resultRendering(pi);
  subagent(pi);
  capability(pi);
  btw(pi);
}
