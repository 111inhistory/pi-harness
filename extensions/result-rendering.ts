import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installResultRendering } from '../src/result-rendering.ts';

export default function resultRendering(pi: ExtensionAPI): void {
  installResultRendering(pi);
}
