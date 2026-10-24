import path from "node:path";
import { prepareEndpoint, releaseEndpoint } from "./ipc/endpoint.ts";

export const unixIpc = {
  agentPath: (id, root) => path.join(root, `${id}.sock`),
  broadcastPath: (id, root) => path.join(root, id, "children.sock"),
  key: (address) => path.resolve(address),
  isEndpoint: (address) => typeof address === "string" && address.endsWith(".sock"),
  isNamespace: () => false,
  /**
   * Safe preparation lives in the ownership helper. It refuses symlinks,
   * ordinary files, foreign or active endpoints instead of unlinking them.
   */
  prepare(address) {
    return prepareEndpoint({ address });
  },
  /**
   * Removal requires the identity recorded when this process bound the
   * endpoint. Without it there is no proof of ownership, so nothing is removed.
   */
  remove(address, identity) {
    if (identity === undefined || identity === null) return { removed: false, reason: "not_owned" };
    return releaseEndpoint({ address, namespace: false, identity, staleRemoved: false });
  },
};
