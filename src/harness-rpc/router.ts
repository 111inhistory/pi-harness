/**
 * Method dispatch for the Harness RPC endpoint.
 *
 * `TypedMethodHandlers` binds every `RpcMethod` to its contract-inferred
 * `MethodParams<M>` and `MethodResult<M>`. The router validates incoming
 * parameters once with `parseMethodParams` before invoking the typed handler,
 * enforcing both full method coverage and result shapes at compile time with
 * zero per-handler casts.
 */

import {
  isRpcMethod,
  parseMethodParams,
  type MethodParams,
  type MethodResult,
} from './contract.ts';
import { HARNESS_RPC_PROTOCOL_VERSION, RPC_ERROR, RPC_METHODS, type RpcMethod } from './protocol.ts';
import type { RpcConnection, RpcHandler } from './transport.ts';
import { RpcRequestError } from './error.ts';
import type { ToolPort } from './ports/tool-info.ts';
import type { ApplicationPort } from './ports/application.ts';
import type { SubagentPort } from './ports/subagent.ts';
import type { HistoryPort } from './ports/history.ts';
import type { StreamPort } from './ports/stream.ts';

export interface RouterDeps {
  readonly sessionId: string;
  readonly tool: ToolPort;
  readonly subagent: SubagentPort;
  readonly history: HistoryPort;
  readonly stream: StreamPort;
  readonly application?: ApplicationPort;
}

export type TypedMethodHandlers = {
  readonly [M in RpcMethod]: (
    params: MethodParams<M>,
    connection: RpcConnection,
  ) => MethodResult<M> | Promise<MethodResult<M>>;
};

function dispatchMethod<M extends RpcMethod>(
  handlers: TypedMethodHandlers,
  method: M,
  rawParams: unknown,
  connection: RpcConnection,
): MethodResult<M> | Promise<MethodResult<M>> {
  const params = parseMethodParams(method, rawParams);
  return handlers[method](params, connection);
}

export function createTypedRouter(handlers: TypedMethodHandlers): RpcHandler {
  return async (request, connection) => {
    if (!isRpcMethod(request.method)) {
      throw new RpcRequestError(RPC_ERROR.methodNotFound, `Unknown method "${request.method}".`);
    }
    return dispatchMethod(handlers, request.method, request.params, connection);
  };
}

export function createRouter(deps: RouterDeps): RpcHandler {
  const application = () => {
    if (deps.application === undefined) throw new RpcRequestError(RPC_ERROR.unavailable, 'Session operations are not installed on this host.');
    return deps.application;
  };
  return createTypedRouter({
    [RPC_METHODS.info]: () => ({
      protocolVersion: HARNESS_RPC_PROTOCOL_VERSION,
      sessionId: deps.sessionId,
      pid: process.pid,
    }),

    [RPC_METHODS.toolsCatalog]: (params) => deps.tool.catalog(params),
    [RPC_METHODS.toolsDetail]: (params) => deps.tool.detail(params),
    [RPC_METHODS.toolsEnable]: (params) => deps.tool.enable(params),
    [RPC_METHODS.permissionQuery]: (params) => deps.tool.permissionQuery(params),
    [RPC_METHODS.permissionEnable]: (params) => deps.tool.permissionEnable(params),
    [RPC_METHODS.permissionDisable]: (params) => deps.tool.permissionDisable(params),
    [RPC_METHODS.permissionReset]: (params) => deps.tool.permissionReset(params),

    [RPC_METHODS.agentsTree]: () => deps.subagent.tree(),
    [RPC_METHODS.jobsList]: (params) => deps.subagent.jobs(params),
    [RPC_METHODS.jobsGet]: (params) => deps.subagent.job(params),
    [RPC_METHODS.jobsResult]: (params) => deps.subagent.result(params),
    [RPC_METHODS.subagentCreate]: (params) => deps.subagent.create(params),
    [RPC_METHODS.subagentStop]: (params) => deps.subagent.stop(params),
    [RPC_METHODS.messageSend]: (params) => deps.subagent.send(params),

    [RPC_METHODS.historyRead]: (params) => deps.history.read(params),

    [RPC_METHODS.streamSubscribe]: (params, connection) => deps.stream.subscribe(params, connection),
    [RPC_METHODS.streamUnsubscribe]: (params, connection) => deps.stream.unsubscribe(params, connection),
    [RPC_METHODS.presetsCatalog]: () => application().presetsCatalog(),
    [RPC_METHODS.presetsCurrent]: () => application().presetsCurrent(),
    [RPC_METHODS.presetsApply]: params => application().presetsApply(params),
    [RPC_METHODS.presetsClear]: () => application().presetsClear(),
    [RPC_METHODS.approvalsList]: () => application().approvalsList(),
    [RPC_METHODS.approvalsGet]: params => application().approvalsGet(params),
    [RPC_METHODS.approvalsRespond]: params => application().approvalsRespond(params),
    [RPC_METHODS.approvalsSubscribe]: (_params, connection) => application().approvalsSubscribe(connection),
    [RPC_METHODS.sessionsList]: () => application().sessionsList(),
    [RPC_METHODS.sessionsConnect]: params => application().sessionsConnect(params),
  });
}
