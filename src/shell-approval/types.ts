/** Actual execution inputs passed to an optional command policy program. */
export interface ShellApprovalAction {
  readonly version: 1;
  readonly shell: string;
  readonly command: string;
  readonly cwd: string;
  readonly platform: 'posix' | 'windows';
  readonly source: string;
  readonly argv?: readonly string[];
  readonly rules?: readonly string[];
}

export type ShellPolicyDecision = {
  readonly decision: 'allow' | 'deny' | 'review';
  readonly reason: string;
};
export type ShellPermissionMode = 'ask' | 'auto' | 'yolo';

/** Why a manual shell approval request settled. */
export type ShellApprovalReason =
  | 'approved'
  | 'rejected'
  | 'timeout'
  | 'cancelled'
  | 'no_ui'
  | 'disposed';

export interface ShellApprovalResult {
  readonly approved: boolean;
  readonly reason: ShellApprovalReason;
}

/** One root-owned manual approval request. `signal` follows the requesting turn. */
export interface ShellApprovalRequest {
  readonly sourceAgent: string;
  readonly shell: string;
  readonly cwd: string;
  readonly command: string;
  readonly reason?: string | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** A client adapter may only choose between these two outcomes. */
export type ShellApprovalDecision = 'allow' | 'deny';

/** Immutable pending view shared by terminal and RPC adapters. */
export interface ShellApprovalPending {
  readonly id: string;
  readonly sourceAgent: string;
  readonly shell: string;
  readonly cwd: string;
  readonly command: string;
  readonly reason: string | null;
  readonly state: 'queued' | 'active';
  readonly timeoutSeconds: number;
  readonly requestedAt: number;
  /** The active request's deadline; queued requests have not started their timeout yet. */
  readonly expiresAt: number | null;
}

export type ShellApprovalSnapshot = readonly ShellApprovalPending[];

export type ShellApprovalRespondResult =
  | { readonly accepted: true; readonly decision: ShellApprovalDecision }
  | {
      readonly accepted: false;
      readonly reason: 'not_pending' | 'invalid_decision' | 'disposed';
    };

/**
 * The root-lifetime approval state shared by every adapter. Adapters only
 * observe pending snapshots and answer a known request; they never supply the
 * requesting identity, timeout or command.
 */
export interface ShellApprovalController {
  request(request: ShellApprovalRequest): Promise<ShellApprovalResult>;
  list(): ShellApprovalSnapshot;
  get(id: string): ShellApprovalPending | undefined;
  respond(id: string, decision: ShellApprovalDecision): ShellApprovalRespondResult;
  subscribe(listener: (snapshot: ShellApprovalSnapshot) => void, options?: { readonly consumer?: boolean }): () => void;
  dispose(): void;
}
