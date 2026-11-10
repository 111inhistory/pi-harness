/**
 * A structured request failure with a stable code. Handlers throw this for
 * expected refusals; the transport serializes it to an error response. Anything
 * else a handler throws is reported as an internal error.
 */
export class RpcRequestError extends Error {
  readonly code: string;
  readonly detail: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'RpcRequestError';
    this.code = code;
    this.detail = detail;
  }
}
