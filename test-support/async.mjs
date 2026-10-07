import { setTimeout } from "node:timers/promises";

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Wait for an observable condition, not an assumed processing delay. */
export async function waitFor(check, { label = "condition", timeoutMs = 3000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await setTimeout(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
