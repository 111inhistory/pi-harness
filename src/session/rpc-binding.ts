import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RootService } from '../subagent/root-service.ts';

/** Host-owned admission. Subagent storage health is not session admission. */
export interface RpcSessionBinding {
  readonly api: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly root: RootService;
  readonly assertSession: () => void;
  /** Reopen domain services after SDK navigation is canceled. */
  readonly resume?: () => Promise<void>;
}
