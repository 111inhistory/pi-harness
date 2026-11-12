/** Task paths shared by the TS host and the native CLI. */
import os from "node:os";
import path from "node:path";

import { AsyncShellError } from "./errors.ts";
import { isTaskId } from "./task-id.ts";

export function stateRoot(): string {
  return path.resolve(process.env.PI_ASYNC_SHELL_ROOT || path.join(os.tmpdir(), `pi-async-shell-${process.getuid?.() ?? 0}`));
}

export function taskDirectory(id: string, root = stateRoot()): string {
  if (!isTaskId(id)) throw new AsyncShellError("invalid_id", `Not an async-shell task id: ${id}`);
  return path.join(root, id);
}
