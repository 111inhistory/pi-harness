import fs from "node:fs";
import path from "node:path";

export const unixIpc = {
  agentPath: (id, root) => path.join(root, `${id}.sock`),
  broadcastPath: (id, root) => path.join(root, id, "children.sock"),
  key: (address) => path.resolve(address),
  isEndpoint: (address) => typeof address === "string" && address.endsWith(".sock"),
  isNamespace: () => false,
  prepare(address) {
    fs.mkdirSync(path.dirname(address), { recursive: true });
    this.remove(address);
  },
  remove(address) {
    try {
      if (fs.existsSync(address)) fs.unlinkSync(address);
    } catch {
      // Preserve the existing best-effort Unix socket cleanup.
    }
  },
};
