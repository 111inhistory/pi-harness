/** Resolve the installed native CLI, or the explicit test override. */
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function piJobExecutable(): string {
  const configured = process.env.PI_ASYNC_SHELL_CLI;
  if (configured !== undefined && configured !== "") return configured;
  return path.join(getAgentDir(), "bin", process.platform === "win32" ? "pi-job.exe" : "pi-job");
}
