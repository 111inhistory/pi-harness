/**
 * Harness RPC wire protocol (the independent structured endpoint).
 *
 * This is a second channel beside Pi's native RPC: the native stdin/stdout RPC
 * keeps owning Main control and its event stream, while this endpoint carries
 * the tool catalogue, subagent control, message history and child execution
 * streams. It is only assembled when the root host actually runs in RPC mode.
 *
 * Frames are newline-delimited JSON. A client frame is a request
 * `{ id, method, params? }`. A server frame is either a response carrying the
 * request `id`, or a subscription event carrying `event`. The `id` / `event`
 * discriminator keeps the two directions of one connection unambiguous.
 */

export const HARNESS_RPC_PROTOCOL_VERSION = 1;

/** A request correlation id; the client chooses it and gets it back. */
export type RpcId = string | number;

/** A response id is the request id, or null when the request was unparseable. */
export type RpcResponseId = RpcId | null;

export interface RpcRequest {
  readonly id: RpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface RpcErrorBody {
  readonly code: string;
  readonly message: string;
  readonly detail?: unknown;
}

export interface RpcSuccessResponse {
  readonly id: RpcResponseId;
  readonly ok: true;
  readonly result: unknown;
}

export interface RpcFailureResponse {
  readonly id: RpcResponseId;
  readonly ok: false;
  readonly error: RpcErrorBody;
}

export type RpcResponse = RpcSuccessResponse | RpcFailureResponse;

/** One pushed subscription event. `seq` is monotonic per connection (so also within one subscription). */
export interface RpcEventEnvelope {
  readonly subscription: string;
  readonly seq: number;
  readonly payload: unknown;
}

export interface RpcEventFrame {
  readonly event: RpcEventEnvelope;
}

export type RpcServerFrame = RpcResponse | RpcEventFrame;

/** Stable method names. Method names are not a public promise yet (see the proposal's TBDs). */
export const RPC_METHODS = {
  info: 'harness.info',
  toolsCatalog: 'tools.catalog',
  toolsDetail: 'tools.detail',
  toolsEnable: 'tools.enable',
  permissionQuery: 'tools.permission.query',
  permissionEnable: 'tools.permission.enable',
  permissionDisable: 'tools.permission.disable',
  permissionReset: 'tools.permission.reset',
  agentsTree: 'agents.tree',
  jobsList: 'jobs.list',
  jobsGet: 'jobs.get',
  jobsResult: 'jobs.result',
  subagentCreate: 'subagent.create',
  subagentStop: 'subagent.stop',
  messageSend: 'message.send',
  historyRead: 'history.read',
  streamSubscribe: 'stream.subscribe',
  streamUnsubscribe: 'stream.unsubscribe',
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

/** Stable error codes. */
export const RPC_ERROR = {
  invalidRequest: 'invalid_request',
  methodNotFound: 'method_not_found',
  notFound: 'not_found',
  notReady: 'not_ready',
  unavailable: 'unavailable',
  internal: 'internal',
} as const;
