/**
 * Method dispatch for the Harness RPC endpoint.
 *
 * The router maps one validated request to one domain-port call and returns a
 * structured result. It never parses Slash-command output, UI notifications or
 * status-bar text; each port calls the same domain operation the TUI command
 * calls. Expected refusals surface as structured errors; partial results keep
 * their per-item shape.
 */

import { HARNESS_RPC_PROTOCOL_VERSION, RPC_ERROR, RPC_METHODS } from './protocol.ts';
import type { RpcHandler } from './transport.ts';
import { RpcRequestError } from './error.ts';
import type { ToolPort } from './ports/tool-info.ts';
import type { SubagentPort } from './ports/subagent.ts';
import type { HistoryPort } from './ports/history.ts';
import type { StreamPort } from './ports/stream.ts';

export interface RouterDeps {
  readonly sessionId: string;
  readonly tool: ToolPort;
  readonly subagent: SubagentPort;
  readonly history: HistoryPort;
  readonly stream: StreamPort;
}

export function createRouter(deps: RouterDeps): RpcHandler {
  return async (request, connection) => {
    switch (request.method) {
      case RPC_METHODS.info:
        return { protocolVersion: HARNESS_RPC_PROTOCOL_VERSION, sessionId: deps.sessionId, pid: process.pid };

      case RPC_METHODS.toolsCatalog:
        return deps.tool.catalog(request.params);
      case RPC_METHODS.toolsDetail:
        return deps.tool.detail(request.params);
      case RPC_METHODS.toolsEnable:
        return deps.tool.enable(request.params);
      case RPC_METHODS.permissionQuery:
        return deps.tool.permissionQuery(request.params);
      case RPC_METHODS.permissionEnable:
        return deps.tool.permissionEnable(request.params);
      case RPC_METHODS.permissionDisable:
        return deps.tool.permissionDisable(request.params);
      case RPC_METHODS.permissionReset:
        return deps.tool.permissionReset(request.params);

      case RPC_METHODS.agentsTree:
        return deps.subagent.tree();
      case RPC_METHODS.jobsList:
        return deps.subagent.jobs(request.params);
      case RPC_METHODS.jobsGet:
        return deps.subagent.job(request.params);
      case RPC_METHODS.jobsResult:
        return deps.subagent.result(request.params);
      case RPC_METHODS.subagentCreate:
        return deps.subagent.create(request.params);
      case RPC_METHODS.subagentStop:
        return deps.subagent.stop(request.params);
      case RPC_METHODS.messageSend:
        return deps.subagent.send(request.params);

      case RPC_METHODS.historyRead:
        return deps.history.read(request.params);

      case RPC_METHODS.streamSubscribe:
        return deps.stream.subscribe(request.params, connection);
      case RPC_METHODS.streamUnsubscribe:
        return deps.stream.unsubscribe(request.params, connection);

      default:
        throw new RpcRequestError(RPC_ERROR.methodNotFound, `Unknown method "${request.method}".`);
    }
  };
}
