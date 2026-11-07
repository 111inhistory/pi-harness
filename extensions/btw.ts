import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installBtwCommand } from '../src/btw/command.ts';

export default function btw(pi: ExtensionAPI): void {
  installBtwCommand(pi);
}
