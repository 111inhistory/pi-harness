import path from "node:path";

import {
  endpointInsideDirectory,
  prepareEndpoint,
  releaseEndpoint,
  type EndpointLease,
  type EndpointRelease,
} from "./endpoint.ts";
import type { IpcPlatform } from "./platform.ts";

/**
 * The Unix adapter. Address arithmetic uses the POSIX path dialect explicitly,
 * so these pure calculations keep POSIX semantics regardless of the host the
 * adapter is exercised on; the filesystem ownership helpers run on the real
 * host filesystem.
 */
export const unixIpc: IpcPlatform = {
  agentPath: (id, root) => path.posix.join(root, `${id}.sock`),
  broadcastPath: (id, root) => path.posix.join(root, id, "children.sock"),
  key: (address) => path.posix.resolve(address),
  isEndpoint: (address) => typeof address === "string" && address.endsWith(".sock"),
  isNamespace: () => false,
  /**
   * A session's Unix endpoints are the socket files below its directory, so
   * membership is filesystem containment. Comparison stays case-sensitive:
   * POSIX treats differently-cased names as different endpoints.
   */
  belongsToNamespace: (address, socketDir) =>
    typeof address === "string" && address.endsWith(".sock") && endpointInsideDirectory(address, socketDir),
  /**
   * Safe preparation lives in the ownership helper. It refuses symlinks,
   * ordinary files, foreign or active endpoints instead of unlinking them.
   */
  prepare(address): Promise<EndpointLease> {
    return prepareEndpoint({ address });
  },
  /**
   * Removal requires the identity recorded when this process bound the
   * endpoint. Without it there is no proof of ownership, so nothing is removed.
   */
  remove(address, identity): EndpointRelease {
    if (identity === undefined || identity === null) return { removed: false, reason: "not_owned" };
    return releaseEndpoint({ address, namespace: false, identity, staleRemoved: false });
  },
};
