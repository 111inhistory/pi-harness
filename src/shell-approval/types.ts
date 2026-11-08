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
